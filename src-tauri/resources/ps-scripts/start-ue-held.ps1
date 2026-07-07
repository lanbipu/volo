# Starts UnrealEditor.exe and keeps this SSH PowerShell session open while it runs.
#
# Windows sshd kills the child process tree when the SSH session ends. For PSO
# warm-up that is intentional: the held SSH channel is the watchdog, and dropping
# it must tear down the UE process.
#
# stdin: JSON { "EnginePath","ProjectPath","ExtraArgs":[...] }
# First stdout line: JSON { ok, pid, log_path, project_dir, project_name }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

function Convert-UEArgList {
    param([object[]]$ArgsIn)
    $rendered = foreach ($a in $ArgsIn) {
        $s = "$a"
        if ($s -match '\s' -and $s -match '^(-[^=\s]+)=(.+)$') {
            '{0}="{1}"' -f $Matches[1], $Matches[2]
        } elseif ($s -match '\s') {
            '"{0}"' -f $s
        } else {
            $s
        }
    }
    return $rendered
}

function Resolve-UELogPath {
    param(
        [string]$ProjectPath,
        [object[]]$ExtraArgs
    )
    $projDir = [System.IO.Path]::GetDirectoryName($ProjectPath)
    $projName = [System.IO.Path]::GetFileNameWithoutExtension($ProjectPath)
    $logName = $null
    foreach ($a in $ExtraArgs) {
        $s = "$a"
        if ($s -match '(?i)^-?Log=(.+)$') {
            $logName = $Matches[1].Trim().Trim('"')
        }
    }
    if ([string]::IsNullOrWhiteSpace($logName)) {
        $logName = "$projName.log"
    }
    if ([System.IO.Path]::IsPathRooted($logName)) {
        return $logName
    }
    return (Join-Path -Path $projDir -ChildPath "Saved\Logs\$logName")
}

function Assert-NoInteractiveEditor {
    $editors = Get-CimInstance Win32_Process -Filter "Name = 'UnrealEditor.exe'" |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.IndexOf('-game', [System.StringComparison]::OrdinalIgnoreCase) -lt 0
        }
    if ($editors) {
        $pids = ($editors | Select-Object -ExpandProperty ProcessId) -join ','
        throw "interactive UnrealEditor already running without -game (pid=$pids)"
    }
}

$proc = $null
$reported = $false

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $EnginePath = $p.EnginePath
    $ProjectPath = $p.ProjectPath
    $ExtraArgs = @($p.ExtraArgs)

    $exe = Join-Path -Path $EnginePath -ChildPath 'Engine\Binaries\Win64\UnrealEditor.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "UnrealEditor.exe not found at $exe" }
    if (-not (Test-Path -LiteralPath $ProjectPath)) { throw "uproject not found at $ProjectPath" }

    Assert-NoInteractiveEditor

    $projDir = [System.IO.Path]::GetDirectoryName($ProjectPath)
    $projName = [System.IO.Path]::GetFileNameWithoutExtension($ProjectPath)
    $logPath = Resolve-UELogPath -ProjectPath $ProjectPath -ExtraArgs $ExtraArgs
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue

    $rendered = Convert-UEArgList -ArgsIn $ExtraArgs
    $ueArgs = (@("`"$ProjectPath`"") + $rendered) -join ' '
    $proc = Start-Process -FilePath $exe -ArgumentList $ueArgs -PassThru -WindowStyle Hidden

    @{
        ok           = $true
        pid          = "$($proc.Id)"
        log_path     = "$logPath"
        project_dir  = "$projDir"
        project_name = "$projName"
    } | ConvertTo-Json -Compress | ForEach-Object {
        [Console]::Out.WriteLine($_)
        [Console]::Out.Flush()
    }
    $reported = $true

    while (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
        Start-Sleep -Seconds 1
    }
}
catch {
    if (-not $reported) {
        @{ ok = $false; pid = ""; log_path = ""; message = "$($_.Exception.Message)" } |
            ConvertTo-Json -Compress | ForEach-Object {
                [Console]::Out.WriteLine($_)
                [Console]::Out.Flush()
            }
    } else {
        Write-Error "$($_.Exception.Message)"
    }
    exit 1
}
finally {
    if ($proc -and (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
}
