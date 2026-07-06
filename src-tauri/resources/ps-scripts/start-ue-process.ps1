# Spawns UnrealEditor.exe (PassThru, no wait) and returns its PID + log path.
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

    $argList = @("`"$ProjectPath`"") + $ExtraArgs
    $proc = Start-Process -FilePath $exe -ArgumentList $argList -PassThru -WindowStyle Hidden
    # [IO.Path]::GetDirectoryName avoids `Split-Path -LiteralPath -Parent` (invalid param-set, PS5.1).
    $projDir = [System.IO.Path]::GetDirectoryName($ProjectPath)
    $projName = [System.IO.Path]::GetFileNameWithoutExtension($ProjectPath)
    $logPath = Join-Path -Path $projDir -ChildPath ("Saved\Logs\$projName.log")

    @{
        ok           = $true
        pid          = "$($proc.Id)"
        log_path     = "$logPath"
        project_dir  = "$projDir"
        project_name = "$projName"
    } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; pid = ""; log_path = ""; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}
