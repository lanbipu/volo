# DDC pak preflight: checks editor exe + project + DerivedDataCache dir exist.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "EnginePath": "...", "ProjectPath": "..." }
# Output: JSON { ok, exe_exists, proj_exists, ddc_dir_exists, ddc_dir }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Continue'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $EnginePath = $p.EnginePath
    $ProjectPath = $p.ProjectPath

    $exe = Join-Path -Path $EnginePath -ChildPath 'Engine\Binaries\Win64\UnrealEditor.exe'
    $existsExe = Test-Path -LiteralPath $exe
    $existsProject = Test-Path -LiteralPath $ProjectPath
    # [IO.Path]::GetDirectoryName avoids `Split-Path -LiteralPath -Parent` (invalid
    # parameter-set combo on Windows PowerShell 5.1).
    $projectDir = [System.IO.Path]::GetDirectoryName($ProjectPath)
    $ddcDir = Join-Path -Path $projectDir -ChildPath 'DerivedDataCache'
    $hasDdcDir = Test-Path -LiteralPath $ddcDir

    @{
        ok             = $true
        exe_exists     = ("$existsExe" -eq "True")
        proj_exists    = ("$existsProject" -eq "True")
        ddc_dir_exists = ("$hasDdcDir" -eq "True")
        ddc_dir        = "$ddcDir"
    } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}
