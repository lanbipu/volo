# Spawns UnrealEditor.exe in the INTERACTIVE console session via a scheduled task
# (Session 0 evasion: SSH runs as a network logon, plain Start-Process would render
# nothing on a real node; -LogonType Interactive puts UE on the user's desktop.
# Technique verified on lanPC 2026-07-02: session_id=1, GPU 3D ~75%).
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "EnginePath","ProjectPath","ExtraArgs":[...] }
# Output: JSON { ok, pid, log_path, project_dir, project_name }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $EnginePath = $p.EnginePath
    $ProjectPath = $p.ProjectPath
    $ExtraArgs = @($p.ExtraArgs)

    $exe = Join-Path -Path $EnginePath -ChildPath 'Engine\Binaries\Win64\UnrealEditor.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "UnrealEditor.exe not found at $exe" }
    if (-not (Test-Path -LiteralPath $ProjectPath)) { throw "uproject not found at $ProjectPath" }

    $consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName
    if ([string]::IsNullOrWhiteSpace($consoleUser)) {
        throw 'no interactive console user logged on (required for -game rendering)'
    }

    # Rebuild each arg into verified command-line syntax: a "-Key=value with spaces"
    # element becomes -Key="value with spaces" (value-quoted, as UE expects).
    $rendered = foreach ($a in $ExtraArgs) {
        $s = "$a"
        if ($s -match '\s' -and $s -match '^(-[^=\s]+)=(.+)$') {
            '{0}="{1}"' -f $Matches[1], $Matches[2]
        } elseif ($s -match '\s') {
            '"{0}"' -f $s
        } else {
            $s
        }
    }
    $ueArgs = (@("`"$ProjectPath`"") + $rendered) -join ' '

    $projDir = [System.IO.Path]::GetDirectoryName($ProjectPath)
    $projName = [System.IO.Path]::GetFileNameWithoutExtension($ProjectPath)
    # Honor an explicit Log=<name> in ExtraArgs (warmup uses per-run log names);
    # last match wins, relative names resolve under Saved\Logs.
    $logName = "$projName.log"
    foreach ($a in $ExtraArgs) {
        if ($a -match '^-?[Ll][Oo][Gg]=(.+)$') { $logName = $Matches[1].Trim('"') }
    }
    if ([System.IO.Path]::IsPathRooted($logName)) {
        $logPath = $logName
    } else {
        $logPath = Join-Path -Path $projDir -ChildPath ("Saved\Logs\" + $logName)
    }
    # A leftover log from the previous run would be tailed from offset 0 as if
    # it were this run's output (stale hitch lines / instant exit markers).
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue

    # Unique per-invocation task name: overlapping launches on the same node
    # must not unregister each other's task mid-start.
    $taskName = "UECM-UE-Interactive-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    $act = New-ScheduledTaskAction -Execute $exe -Argument $ueArgs
    $prn = New-ScheduledTaskPrincipal -UserId $consoleUser -LogonType Interactive -RunLevel Limited
    $set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 12) -AllowStartIfOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $act -Principal $prn -Settings $set -Force | Out-Null
    $t0 = Get-Date
    Start-ScheduledTask -TaskName $taskName

    # Identify OUR process by command line (an editor may already be open).
    # Literal substring match — -like would apply wildcard semantics and paths
    # containing [ ] would never match (or throw).
    $proc = $null
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 1500
        $proc = Get-CimInstance Win32_Process -Filter "Name = 'UnrealEditor.exe'" |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine.IndexOf($ProjectPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                $_.CreationDate -ge $t0.AddSeconds(-5)
            } |
            Select-Object -First 1
        if ($proc) { break }
    }
    if (-not $proc) {
        # UE may already be running unidentified — stop the task INSTANCE first
        # (kills its action process) so a failed identification never leaks a
        # fullscreen -game onto the node, then drop the definition.
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        throw 'UnrealEditor did not appear within 90s of task start (task instance stopped)'
    }
    # Task definition is disposable once the process is identified (deleting it
    # does not kill the running instance); stop flow kills by PID.
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

    @{
        ok           = $true
        pid          = "$($proc.ProcessId)"
        log_path     = "$logPath"
        project_dir  = "$projDir"
        project_name = "$projName"
    } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; pid = ""; log_path = ""; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}
