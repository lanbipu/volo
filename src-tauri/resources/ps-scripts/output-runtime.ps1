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
        Reply $true "preflight passed; UE $version"
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

    if ($action -eq "start") {
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
