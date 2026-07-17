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
            @{ Name = "UnrealEditor"; Path = [string]$request.editor_path },
            @{ Name = "project"; Path = [string]$request.project_path },
            @{ Name = "nDisplay config"; Path = [string]$request.config_path }
        )) {
            if (-not (Test-Path -LiteralPath $item.Path -PathType Leaf)) { $missing += "$($item.Name): $($item.Path)" }
        }
        if ($missing.Count -gt 0) { throw "missing runtime files: $($missing -join '; ')" }

        $manifestDir = Split-Path -Parent ([string]$request.manifest_path)
        if (-not [string]::IsNullOrWhiteSpace($manifestDir)) { New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null }
        New-Item -ItemType Directory -Force -Path ([string]$request.image_dir) | Out-Null
        $version = (Get-Item -LiteralPath ([string]$request.editor_path)).VersionInfo.ProductVersion
        Reply $true "preflight passed; UE $version"
        exit 0
    }

    if ($action -eq "start") {
        $project = [string]$request.project_path
        $nodeId = [string]$request.node_id
        $logDir = Join-Path (Split-Path -Parent $project) "Saved\Logs"
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $logPath = Join-Path $logDir "VoloOutput-$nodeId.log"
        $arguments = @(
            ('"{0}"' -f $project),
            '-game', '-messaging', '-dc_cluster', '-dc_dev_mono',
            ('-dc_cfg="{0}"' -f ([string]$request.config_path)),
            ('-dc_node={0}' -f $nodeId),
            '-windowed',
            ('-ResX={0}' -f [int]$request.window_width),
            ('-ResY={0}' -f [int]$request.window_height),
            '-RemoteControlIsHeadless', '-RCWebControlEnable', '-ClusterForceApplyResponse',
            ('-abslog="{0}"' -f $logPath)
        )
        # This is the operator-visible nDisplay output window, so it must not be hidden.
        $process = Start-Process -FilePath ([string]$request.editor_path) -ArgumentList $arguments -PassThru

        # A PID is deliberately not the success criterion. Wait for cluster/render
        # connection evidence emitted by DisplayCluster in this node's UE log.
        $deadline = (Get-Date).AddSeconds(60)
        $evidence = $null
        $patterns = @(
            'LogDisplayClusterCluster:.*(connected|connection established|joined|synchronization)',
            'LogDisplayClusterNetwork:.*(connected|connection established)',
            'LogDisplayClusterCluster:.*barrier.*(activated|synchronized)'
        )
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $logPath) {
                $match = Select-String -LiteralPath $logPath -Pattern $patterns -CaseSensitive:$false | Select-Object -Last 1
                if ($null -ne $match) { $evidence = $match.Line.Trim(); break }
            }
            if ($process.HasExited) { throw "UE exited before cluster log evidence (exit $($process.ExitCode)); log=$logPath" }
            Start-Sleep -Milliseconds 500
            $process.Refresh()
        }
        if ($null -eq $evidence) { throw "timeout waiting for cluster log evidence; PID=$($process.Id); log=$logPath" }
        Reply $true "PID=$($process.Id); $evidence" $true
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
