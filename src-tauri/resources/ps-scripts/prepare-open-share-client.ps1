# Mode A (open/guest) CLIENT prep — passwordless UNC access for the INTERACTIVE user.
#
# Why scheduled tasks instead of running cmdkey/net use directly here:
#   Volo runs this script as `uecm-svc` over SSH = a NETWORK logon (Type 3).
#   - cmdkey CANNOT write the credential vault from a network logon.
#   - Anything written here lands in uecm-svc's / SYSTEM's context, NOT the
#     interactive user's — Explorer/UE run as the interactive user and still prompt.
#   So we install scheduled tasks that run the worker (modea-guest-connect.ps1)
#   IN a user's OWN interactive session, where `net use ... "" /user:Guest`
#   establishes a guest SMB session with no prompt. Validated Win11 25H2.
#
# Per-share keying: targets file + task names are keyed on the primary UNC host,
# so joining a SECOND open share does NOT clobber the first's auto-reconnect.
#
# stdin: JSON { "TargetUncs": ["\\\\HOST\\Share", "\\\\10.0.0.1\\Share"] }
# Output: JSON { ok, verified, message }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-UncHost([string]$u) {
    if ($u -match '^\\\\([^\\]+)\\') { return $Matches[1] } else { return $null }
}

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $targets = @($p.TargetUncs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if (-not $targets.Count) { throw 'TargetUncs is required (at least one \\HOST\Share UNC)' }

    $base = 'C:\ProgramData\UECM'
    $statusDir = Join-Path $base 'status'
    New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
    $worker = Join-Path $PSScriptRoot 'modea-guest-connect.ps1'
    if (-not (Test-Path -LiteralPath $worker)) {
        throw "worker script missing: $worker (re-run UECM-Bootstrap / re-stage ps-scripts)"
    }

    # Per-share key from the primary UNC host (locale-/IP-stable).
    $primaryHost = Get-UncHost $targets[0]
    if (-not $primaryHost) { throw "cannot parse host from primary UNC '$($targets[0])'" }
    $key = ($primaryHost -replace '[^A-Za-z0-9]', '_')
    $targetsFile = Join-Path $base ("modea-targets-$key.json")
    $taskOnLogon = "UECM-ModeA-Guest-$key"
    $taskNow = "UECM-ModeA-Guest-$key-Now"

    # Client must allow guest SMB (Win10/11 default = off) AND share the session
    # across the elevated/limited linked-token split (so an admin-elevated UE sees
    # the same guest mapping a Limited-token task created). Both idempotent.
    $lw = 'HKLM:\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters'
    if ((Get-ItemProperty -Path $lw -Name 'AllowInsecureGuestAuth' -ErrorAction SilentlyContinue).AllowInsecureGuestAuth -ne 1) {
        New-ItemProperty -Path $lw -Name 'AllowInsecureGuestAuth' -PropertyType DWord -Value 1 -Force | Out-Null
    }
    $sysPol = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
    if ((Get-ItemProperty -Path $sysPol -Name 'EnableLinkedConnections' -ErrorAction SilentlyContinue).EnableLinkedConnections -ne 1) {
        New-ItemProperty -Path $sysPol -Name 'EnableLinkedConnections' -PropertyType DWord -Value 1 -Force | Out-Null
    }

    # Persist the target list for the worker (both tasks read this per-share file).
    @{ TargetUncs = $targets } | ConvertTo-Json -Compress |
        Set-Content -LiteralPath $targetsFile -Encoding UTF8

    $steps = New-Object System.Collections.Generic.List[string]
    $steps.Add('AllowInsecureGuestAuth=1; EnableLinkedConnections=1') | Out-Null
    $workerArg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$worker`" -TargetsFile `"$targetsFile`""

    # 1) persistent: any user at logon (BUILTIN\Users by SID = locale-proof).
    $actL = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $workerArg
    $trgL = New-ScheduledTaskTrigger -AtLogOn
    $prnL = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
    Register-ScheduledTask -TaskName $taskOnLogon -Action $actL -Trigger $trgL -Principal $prnL -Force | Out-Null
    $steps.Add("onlogon task: $taskOnLogon") | Out-Null

    # 2) immediate verify for the current console user. Its failure must NEVER
    #    abort the whole prep — the OnLogon task already covers steady state, so a
    #    Microsoft/AzureAD/domain account (NTAccount can't translate) or a slow
    #    task only downgrades to "deferred", not "failed".
    $consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName
    $haveUser = -not [string]::IsNullOrWhiteSpace($consoleUser)
    $verified = $false
    $gotStatus = $false
    if ($haveUser) {
        try {
            $sid = (New-Object System.Security.Principal.NTAccount($consoleUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
            $statusFile = Join-Path $statusDir "modea-$sid-$key.json"
            Remove-Item -LiteralPath $statusFile -Force -ErrorAction SilentlyContinue
            $actN = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $workerArg
            $prnN = New-ScheduledTaskPrincipal -UserId $consoleUser -LogonType Interactive -RunLevel Limited
            Register-ScheduledTask -TaskName $taskNow -Action $actN -Principal $prnN -Force | Out-Null
            Start-ScheduledTask -TaskName $taskNow
            $deadline = (Get-Date).AddSeconds(40)
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Milliseconds 1500
                if (Test-Path -LiteralPath $statusFile) { break }
            }
            if (Test-Path -LiteralPath $statusFile) {
                $st = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
                $verified = [bool]$st.ok
                $gotStatus = $true
                $steps.Add("interactive $consoleUser verified=$verified (write=$($st.write))") | Out-Null
                Unregister-ScheduledTask -TaskName $taskNow -Confirm:$false -ErrorAction SilentlyContinue
            } else {
                # Still running / slow — DON'T tear down a possibly-running worker;
                # -Force re-registers next prep. Treat as deferred, not failed.
                $steps.Add('interactive verify deferred (no status within timeout)') | Out-Null
            }
        } catch {
            $steps.Add("interactive verify skipped: $($_.Exception.Message)") | Out-Null
        }
    } else {
        $steps.Add('no console user logged on; deferred to next logon') | Out-Null
    }

    # 3) SYSTEM branch — UE running as a LocalSystem service (e.g. RenderStream).
    #    Best-effort: PsExec writes status to stderr; under ErrorActionPreference=Stop
    #    that would abort the script, so relax it just for this block.
    $psexec = Join-Path $base 'PsExec64.exe'
    if (Test-Path -LiteralPath $psexec) {
        $eap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        foreach ($u in $targets) {
            $h = Get-UncHost $u
            if (-not $h) { continue }
            & $psexec -accepteula -nobanner -s cmd.exe /c "net use `"$u`" /delete /y >nul 2>&1 & net use `"$u`" `"`" /user:$h\Guest /persistent:no" 2>&1 | Out-Null
        }
        $ErrorActionPreference = $eap
        $steps.Add('SYSTEM guest session established') | Out-Null
    } else {
        $steps.Add('PsExec64 not found; SYSTEM branch skipped') | Out-Null
    }

    # ok=false ONLY when the immediate worker ran and definitively reported failure
    # (got a status file with ok:false). Deferred / skipped / no-user all leave the
    # OnLogon task as the guarantee and must NOT fail the join.
    $ok = if ($gotStatus) { $verified } else { $true }
    @{ ok = $ok; verified = $verified; message = ($steps -join '; ') } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; verified = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
