# Mode B (managed) CLIENT prep — Explorer/UE access for the INTERACTIVE user.
#
# Same network-logon constraint as Mode A: SSH runs as uecm-svc (Type 3), so cmdkey
# here would NOT reach the desktop user's vault. We install OnLogon + immediate-verify
# scheduled tasks that run modeb-svc-connect.ps1 IN the interactive session.
#
# Also runs the SYSTEM branch (PsExec cmdkey) so LocalSystem services reach the share.
#
# stdin: JSON {
#   "TargetUncs": ["\\\\LANPC\\Share"],
#   "CmdkeyTargets": ["LANPC","192.168.10.20"],
#   "SvcServerName": "LANPC",
#   "SvcUsername": "ddc-svc",
#   "SvcPassword": "..."
# }
# Output: JSON { ok, verified, message }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-UncHost([string]$u) {
    if ($u -match '^\\\\([^\\]+)\\') { return $Matches[1] } else { return $null }
}

$base = 'C:\ProgramData\UECM'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $targets = @($p.TargetUncs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $cmdkeyTargets = @($p.CmdkeyTargets | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $serverName = [string]$p.SvcServerName
    $user = [string]$p.SvcUsername
    $pass = [string]$p.SvcPassword
    if (-not $targets.Count) { throw 'TargetUncs is required' }
    if (-not $cmdkeyTargets.Count) { throw 'CmdkeyTargets is required' }
    if ([string]::IsNullOrWhiteSpace($serverName)) { throw 'SvcServerName is required' }
    if ([string]::IsNullOrWhiteSpace($user)) { throw 'SvcUsername is required' }
    if ([string]::IsNullOrEmpty($pass)) { throw 'SvcPassword is required' }

    $statusDir = Join-Path $base 'status'
    New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
    $worker = Join-Path $PSScriptRoot 'modeb-svc-connect.ps1'
    if (-not (Test-Path -LiteralPath $worker)) {
        throw "worker script missing: $worker (re-run UECM-Bootstrap / re-stage ps-scripts)"
    }

    $primaryHost = Get-UncHost $targets[0]
    if (-not $primaryHost) { throw "cannot parse host from primary UNC '$($targets[0])'" }
    $key = ($primaryHost -replace '[^A-Za-z0-9]', '_')
    $configFile = Join-Path $base ("modeb-targets-$key.json")
    $secretFile = Join-Path $base ("modeb-secret-$key.txt")
    $taskOnLogon = "UECM-ModeB-Svc-$key"
    $taskNow = "UECM-ModeB-Svc-$key-Now"

    # Linked connections so elevated UE sees mappings from Limited-token tasks.
    $sysPol = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
    if ((Get-ItemProperty -Path $sysPol -Name 'EnableLinkedConnections' -ErrorAction SilentlyContinue).EnableLinkedConnections -ne 1) {
        New-ItemProperty -Path $sysPol -Name 'EnableLinkedConnections' -PropertyType DWord -Value 1 -Force | Out-Null
    }

    Set-Content -LiteralPath $secretFile -Value $pass -Encoding UTF8 -NoNewline
    icacls $secretFile /inheritance:r /grant:r "SYSTEM:(R)" "BUILTIN\Users:(R)" "BUILTIN\Administrators:(F)" | Out-Null

    @{
        TargetUncs = $targets
        CmdkeyTargets = $cmdkeyTargets
        SvcServerName = $serverName
        SvcUsername = $user
        Key = $key
        SecretFile = $secretFile
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $configFile -Encoding UTF8

    $steps = New-Object System.Collections.Generic.List[string]
    $steps.Add('EnableLinkedConnections=1') | Out-Null
    $workerArg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$worker`" -ConfigFile `"$configFile`""

    $actL = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $workerArg
    $trgL = New-ScheduledTaskTrigger -AtLogOn
    $prnL = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
    Register-ScheduledTask -TaskName $taskOnLogon -Action $actL -Trigger $trgL -Principal $prnL -Force | Out-Null
    $steps.Add("onlogon task: $taskOnLogon") | Out-Null

    $consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName
    $haveUser = -not [string]::IsNullOrWhiteSpace($consoleUser)
    $verified = $false
    $gotStatus = $false
    if ($haveUser) {
        try {
            $sid = (New-Object System.Security.Principal.NTAccount($consoleUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
            $statusFile = Join-Path $statusDir "modeb-$sid-$key.json"
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
                $steps.Add('interactive verify deferred (no status within timeout)') | Out-Null
            }
        } catch {
            $steps.Add("interactive verify skipped: $($_.Exception.Message)") | Out-Null
        }
    } else {
        $steps.Add('no console user logged on; deferred to next logon') | Out-Null
    }

    # SYSTEM branch — UE / RenderStream running as LocalSystem.
    $injectScript = Join-Path $PSScriptRoot 'inject-system-credential.ps1'
    $qualified = "$serverName\$user"
    if (Test-Path -LiteralPath $injectScript) {
        foreach ($t in $cmdkeyTargets) {
            $payload = @{ TargetHost = $t; SvcServerName = $serverName; SvcUsername = $user; SvcPassword = $pass } | ConvertTo-Json -Compress
            $null = ($payload | powershell.exe -NoProfile -ExecutionPolicy Bypass -File $injectScript 2>&1)
        }
        $steps.Add("SYSTEM creds via inject-system-credential ($($cmdkeyTargets.Count) targets)") | Out-Null
    } else {
        $psexec = Join-Path $base 'PsExec64.exe'
        if (Test-Path -LiteralPath $psexec) {
            $eap = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            foreach ($t in $cmdkeyTargets) {
                & $psexec -accepteula -nobanner -s cmdkey.exe "/add:$t" "/user:$qualified" "/pass:$pass" 2>&1 | Out-Null
            }
            $ErrorActionPreference = $eap
            $steps.Add('SYSTEM cmdkey via PsExec') | Out-Null
        } else {
            $steps.Add('PsExec64 not found; SYSTEM branch skipped') | Out-Null
        }
    }

    $ok = if ($gotStatus) { $verified } else { $true }
    @{ ok = $ok; verified = $verified; message = ($steps -join '; ') } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; verified = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
