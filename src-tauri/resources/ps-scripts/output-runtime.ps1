# nDisplay output node runtime. One compact JSON request is read from stdin.
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Reply([bool]$Ok, [string]$Message, [bool]$ClusterConnected = $false) {
    @{ ok = $Ok; message = $Message; cluster_connected = $ClusterConnected } |
        ConvertTo-Json -Compress -Depth 8
}

try {
    $line = [Console]::In.ReadLine()
    if ([string]::IsNullOrWhiteSpace($line)) { throw "missing JSON request" }
    $request = $line | ConvertFrom-Json
    $action = [string]$request.action

    if ($action -eq "preflight") {
        $missing = @()
        foreach ($item in @(
            @{ Name = "UnrealEditor"; Path = [string]$request.editor_path }
        )) {
            if (-not (Test-Path -LiteralPath $item.Path -PathType Leaf)) { $missing += "$($item.Name): $($item.Path)" }
        }
        if ($missing.Count -gt 0) { throw "missing runtime files: $($missing -join '; ')" }

        $projectDir = Split-Path -Parent ([string]$request.project_path)
        $manifestDir = Split-Path -Parent ([string]$request.manifest_path)
        New-Item -ItemType Directory -Force -Path $projectDir | Out-Null
        if (-not [string]::IsNullOrWhiteSpace($manifestDir)) { New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null }
        New-Item -ItemType Directory -Force -Path ([string]$request.image_dir) | Out-Null
        # ProductVersion reads like "++UE5+Release-5.8-CL-55116800" so prefix checks fail;
        # the authoritative source is Engine/Build/Build.version (JSON, Major/Minor).
        $engineRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent ([string]$request.editor_path)))
        $buildFile = Join-Path $engineRoot "Build\Build.version"
        if (-not (Test-Path -LiteralPath $buildFile -PathType Leaf)) { throw "cannot determine UE version: missing $buildFile" }
        $build = Get-Content -LiteralPath $buildFile -Raw | ConvertFrom-Json
        $version = "$($build.MajorVersion).$($build.MinorVersion).$($build.PatchVersion)"
        if (-not $version.StartsWith("5.8")) {
            throw "unsupported Unreal Engine $version; VoloOutput Blueprint was saved by UE 5.8 and Phase 1 requires UE 5.8"
        }
        $running = @(Get-CimInstance Win32_Process -Filter "Name='UnrealEditor.exe'" |
            Where-Object { $_.CommandLine } |
            ForEach-Object {
                $summary = ([string]$_.CommandLine -replace '\s+', ' ').Trim()
                if ($summary.Length -gt 180) { $summary = $summary.Substring(0, 180) + '...' }
                "UnrealEditor.exe PID=$($_.ProcessId) command=$summary"
            })
        $warning = if ($running.Count -gt 0) { "; warning: running UE process(es): $($running -join ' | ')" } else { '' }
        Reply $true "preflight passed; UE $version$warning"
        exit 0
    }

    if ($action -eq "prepare_deploy") {
        $projectDir = Split-Path -Parent ([string]$request.project_path)
        @(
            $projectDir,
            (Join-Path $projectDir "Config"),
            (Join-Path $projectDir "Content\VoloOutput"),
            (Split-Path -Parent ([string]$request.config_path)),
            (Split-Path -Parent ([string]$request.manifest_path)),
            ([string]$request.image_dir)
        ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
            New-Item -ItemType Directory -Force -Path $_ | Out-Null
        }
        Reply $true "deployment directories ready"
        exit 0
    }

    if ($action -eq "publish_text") {
        $destination = [string]$request.config_path
        $parent = Split-Path -Parent $destination
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
        $temp = "$destination.tmp"
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($temp, [string]$request.content, $utf8NoBom)
        Move-Item -LiteralPath $temp -Destination $destination -Force
        Reply $true "nDisplay config deployed"
        exit 0
    }

    if ($action -eq "launch") {
        $project = [string]$request.project_path
        $nodeId = [string]$request.node_id
        $projectDir = Split-Path -Parent $project
        $asset = Join-Path $projectDir "Content\VoloOutput\BP_VoloOutput.uasset"
        foreach ($item in @(
            @{ Name = "project"; Path = $project },
            @{ Name = "nDisplay config"; Path = [string]$request.config_path },
            @{ Name = "Blueprint asset"; Path = $asset }
        )) {
            if (-not (Test-Path -LiteralPath $item.Path -PathType Leaf)) { throw "start gate missing $($item.Name): $($item.Path)" }
        }
        $logDir = Join-Path (Split-Path -Parent $project) "Saved\Logs"
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $logPath = Join-Path $logDir "VoloOutput-$nodeId.log"
        $existing = @(Get-CimInstance Win32_Process -Filter "Name='UnrealEditor.exe'" |
            Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($project, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
        if ($existing.Count -gt 0) {
            $pids = ($existing | ForEach-Object { $_.ProcessId }) -join ', '
            throw "VoloOutput project is already running (PID=$pids); stop it before starting again: $project"
        }
        $arguments = @(
            ('"{0}"' -f $project),
            '-game', '-messaging', '-dc_cluster', '-dc_dev_mono',
            ('-dc_cfg="{0}"' -f ([string]$request.config_path)),
            ('-dc_node={0}' -f $nodeId),
            '-windowed',
            ('-ResX={0}' -f [int]$request.window_width),
            ('-ResY={0}' -f [int]$request.window_height),
            # UE only reads .ndisplay window x/y through a launcher (Switchboard
            # passes -WinX/-WinY); the engine itself ignores them in -game mode.
            ('-WinX={0}' -f [int]$request.window_x),
            ('-WinY={0}' -f [int]$request.window_y),
            '-RemoteControlIsHeadless', '-RCWebControlEnable', '-ClusterForceApplyResponse',
            # dc_dev_mono marks views as stereo views; the engine then draws the
            # "StereoView / Stereo rendering method" on-screen debug lines
            # (SceneRendering.cpp, !UE_BUILD_SHIPPING). Not acceptable on an LED wall.
            '-NoScreenMessages',
            ('-abslog="{0}"' -f $logPath)
        )
        # SSH runs as a network logon (session 0): Start-Process there has no desktop
        # and D3D12 device creation fails with DXGI_ERROR_NOT_CURRENTLY_AVAILABLE.
        # Launch through an Interactive-logon scheduled task instead (the verified
        # technique from start-ue-interactive.ps1 / PSO warmup).
        $consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName
        if ([string]::IsNullOrWhiteSpace($consoleUser)) {
            throw "no interactive console user logged on (required for -game rendering)"
        }
        Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
        # The task action is a small launcher running IN the interactive session:
        # it starts UE, waits for the main window, then flips TOPMOST on and off
        # (SetWindowPos) to raise it above existing windows. Windows foreground
        # lock blocks background-spawned windows from surfacing on their own.
        $launcherPath = Join-Path $projectDir "launch-$nodeId.ps1"
        $exeQ = ([string]$request.editor_path) -replace "'", "''"
        $argQ = ($arguments -join ' ') -replace "'", "''"
        $launcherLines = @(
            ('$p = Start-Process -FilePath ''{0}'' -ArgumentList ''{1}'' -PassThru' -f $exeQ, $argQ),
            'Add-Type -TypeDefinition ''using System; using System.Runtime.InteropServices; public class VoloWin { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }''',
            'for ($i = 0; $i -lt 240; $i++) {',
            '    Start-Sleep -Milliseconds 500',
            '    $p.Refresh()',
            '    if ($p.HasExited) { exit 0 }',
            '    if ($p.MainWindowHandle -ne [IntPtr]::Zero) { break }',
            '}',
            'if ($p.MainWindowHandle -ne [IntPtr]::Zero) {',
            '    [VoloWin]::SetWindowPos($p.MainWindowHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null',
            '    [VoloWin]::SetWindowPos($p.MainWindowHandle, [IntPtr](-2), 0, 0, 0, 0, 0x0003) | Out-Null',
            '    [VoloWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null',
            '}'
        )
        Set-Content -LiteralPath $launcherPath -Value $launcherLines -Encoding ASCII
        $taskName = "VoloOutput-$nodeId-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        $act = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $launcherPath)
        $prn = New-ScheduledTaskPrincipal -UserId $consoleUser -LogonType Interactive -RunLevel Limited
        $set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 12) -AllowStartIfOnBatteries
        Register-ScheduledTask -TaskName $taskName -Action $act -Principal $prn -Settings $set -Force | Out-Null
        $t0 = Get-Date
        Start-ScheduledTask -TaskName $taskName
        $process = $null
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 1500
            $process = Get-CimInstance Win32_Process -Filter "Name='UnrealEditor.exe'" |
                Where-Object {
                    $_.CommandLine -and
                    $_.CommandLine.IndexOf($project, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                    $_.CreationDate -ge $t0.AddSeconds(-5)
                } |
                Select-Object -First 1
            if ($process) { break }
        }
        if (-not $process) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
            throw "UnrealEditor did not appear within 90s of task start (task instance stopped); log=$logPath"
        }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Reply $true "launched PID=$($process.ProcessId); log=$logPath"
        exit 0
    }

    if ($action -eq "wait_evidence") {
        $project = [string]$request.project_path
        $nodeId = [string]$request.node_id
        $logDir = Join-Path (Split-Path -Parent $project) "Saved\Logs"
        $logPath = Join-Path $logDir "VoloOutput-$nodeId.log"
        # Create viewport manager is emitted only after the GameStart barrier has
        # passed. Keep older connection patterns as fallbacks for engine variants.
        $deadline = (Get-Date).AddSeconds(240)
        $evidence = $null
        $patterns = @(
            'LogDisplayClusterGame:.*Create viewport manager',
            'LogDisplayClusterCluster:.*(connected|connection established|joined|synchronization)',
            'LogDisplayClusterNetwork:.*(connected|connection established)',
            'LogDisplayClusterCluster:.*barrier.*(activated|synchronized)'
        )
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $logPath) {
                $match = Select-String -LiteralPath $logPath -Pattern $patterns -CaseSensitive:$false | Select-Object -Last 1
                if ($null -ne $match) { $evidence = $match.Line.Trim(); break }
            }
            $process = @(Get-CimInstance Win32_Process -Filter "Name='UnrealEditor.exe'" |
                Where-Object {
                    $_.CommandLine -and
                    $_.CommandLine.IndexOf($project, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                    $_.CommandLine.IndexOf("-dc_node=$nodeId", [StringComparison]::OrdinalIgnoreCase) -ge 0
                }) | Select-Object -First 1
            if ($null -eq $process) { throw "UE exited before cluster render evidence; log=$logPath" }
            Start-Sleep -Milliseconds 500
        }
        if ($null -eq $evidence) { throw "timeout after 240s waiting for cluster render evidence; log=$logPath" }
        Reply $true "$evidence; log=$logPath" $true
        exit 0
    }

    if ($action -eq "stop") {
        $project = [string]$request.project_path
        $processes = @(Get-CimInstance Win32_Process -Filter "Name='UnrealEditor.exe'" |
            Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($project, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
        foreach ($process in $processes) { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
        Reply $true "stopped $($processes.Count) matching UE process(es)"
        exit 0
    }

    if ($action -eq "publish") {
        $destination = [string]$request.manifest_path
        $parent = Split-Path -Parent $destination
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
        $temp = "$destination.tmp"
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($temp, [string]$request.manifest_json, $utf8NoBom)
        Move-Item -LiteralPath $temp -Destination $destination -Force
        Reply $true "manifest atomically replaced"
        exit 0
    }

    throw "unsupported action: $action"
} catch {
    Reply $false $_.Exception.Message
    exit 1
}
