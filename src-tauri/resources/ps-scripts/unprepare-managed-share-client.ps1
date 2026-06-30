# Mode B (managed) CLIENT teardown — undo prepare-managed-share-client.ps1 for ONE share.
#
# Symmetric to prepare: SSH runs as uecm-svc (network logon, Type 3) and cannot
# reach the desktop user's credential vault, so the interactive cmdkey + net use
# that modeb-svc-connect.ps1 created are removed by an Interactive scheduled task
# running modeb-svc-disconnect.ps1 in the console user's session. The SYSTEM
# branch (PsExec) drops the LocalSystem cmdkey + net use mappings.
#
# stdin: JSON {
#   "TargetUncs":    ["\\\\HOST\\Share", ...],   # required
#   "CmdkeyTargets": ["LANPC","192.168.10.20"]   # optional; defaults to UNC hosts
# }
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
    $cmdkeyTargets = @($p.CmdkeyTargets | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if (-not $cmdkeyTargets.Count) {
        # Fall back to the UNC hosts so a teardown still clears cmdkey when the
        # caller (older client) didn't send CmdkeyTargets.
        $cmdkeyTargets = @($targets | ForEach-Object { Get-UncHost $_ } | Where-Object { $_ } | Select-Object -Unique)
    }

    $base = 'C:\ProgramData\UECM'
    $primaryHost = Get-UncHost $targets[0]
    if (-not $primaryHost) { throw "cannot parse host from primary UNC '$($targets[0])'" }
    $key = ($primaryHost -replace '[^A-Za-z0-9]', '_')

    $steps = New-Object System.Collections.Generic.List[string]

    # 1) Interactive cleanup — delete the desktop user's cmdkey + net use from
    #    inside their own session (mirrors prepare's interactive verify task).
    $worker = Join-Path $PSScriptRoot 'modeb-svc-disconnect.ps1'
    $discConfig = Join-Path $base ("modeb-disconnect-$key.json")
    $taskDiscNow = "UECM-ModeB-Disc-$key-Now"
    $consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName
    $discDone = $false
    if ((Test-Path -LiteralPath $worker) -and -not [string]::IsNullOrWhiteSpace($consoleUser)) {
        try {
            @{ TargetUncs = $targets; CmdkeyTargets = $cmdkeyTargets; Key = $key } |
                ConvertTo-Json -Compress | Set-Content -LiteralPath $discConfig -Encoding UTF8
            $sid = (New-Object System.Security.Principal.NTAccount($consoleUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
            $statusDir = Join-Path $base 'status'
            New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
            $statusFile = Join-Path $statusDir "modeb-disc-$sid-$key.json"
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
                # Slow worker — leave the task AND $discConfig in place so it can
                # still finish + clean up (mirrors prepare's "DON'T tear down a
                # possibly-running worker"). -Force replaces it on the next teardown.
                $steps.Add('interactive cleanup deferred (no status within timeout)') | Out-Null
            }
        } catch {
            $steps.Add("interactive cleanup skipped: $($_.Exception.Message)") | Out-Null
            Unregister-ScheduledTask -TaskName $taskDiscNow -Confirm:$false -ErrorAction SilentlyContinue
        }
    } else {
        $steps.Add('no console user / worker missing; interactive cmdkey left for next manual cleanup') | Out-Null
    }

    # 2) Remove the prepare-side scheduled tasks so nothing reconnects at logon.
    foreach ($t in @("UECM-ModeB-Svc-$key-Now", "UECM-ModeB-Svc-$key")) {
        if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
            $steps.Add("removed task $t") | Out-Null
        }
    }

    # 3) Remove the prepare-side config/secret + this teardown's disconnect config.
    #    Keep $discConfig if a deferred worker may still be reading it (step 1).
    $cleanupFiles = @(
        (Join-Path $base "modeb-targets-$key.json"),
        (Join-Path $base "modeb-secret-$key.txt")
    )
    if ($discDone) { $cleanupFiles += $discConfig }
    foreach ($f in $cleanupFiles) {
        if (Test-Path -LiteralPath $f) {
            Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
            $steps.Add("removed $([System.IO.Path]::GetFileName($f))") | Out-Null
        }
    }

    # 4) SSH (uecm-svc) + SYSTEM (PsExec) net use + cmdkey cleanup. The interactive
    #    user's vault was handled in step 1; here we clear the non-interactive
    #    contexts that LocalSystem services (UE/RenderStream) authenticate from.
    $psexec = Join-Path $base 'PsExec64.exe'
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    foreach ($u in $targets) {
        cmd.exe /c "net use `"$u`" /delete /y" 2>&1 | Out-Null
        if (Test-Path -LiteralPath $psexec) {
            & $psexec -accepteula -nobanner -s cmd.exe /c "net use `"$u`" /delete /y >nul 2>&1" 2>&1 | Out-Null
        }
    }
    foreach ($t in $cmdkeyTargets) {
        cmd.exe /c "cmdkey /delete:$t" 2>&1 | Out-Null
        if (Test-Path -LiteralPath $psexec) {
            & $psexec -accepteula -nobanner -s cmd.exe /c "cmdkey /delete:$t >nul 2>&1" 2>&1 | Out-Null
        }
    }
    $ErrorActionPreference = $eap
    $steps.Add('net use + cmdkey removed (uecm-svc + SYSTEM)') | Out-Null

    @{ ok = $true; message = ($steps -join '; ') } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
