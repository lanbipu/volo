# Runs UnrealEditor.exe in nullrhi mode with DDC verbose logging, captures the
# log file path, and returns the parsed log contents up to a configurable size cap.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "EditorExe", "ProjectPath", "TimeoutSeconds", "MaxLogBytes" }
# Output: JSON { ok, log_path, size, truncated, content, exit_code }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
# Fail-fast verify: editor / project must exist; explicit throws -> ok:false.
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $EditorExe = $p.EditorExe
    $ProjectPath = $p.ProjectPath
    $TimeoutSeconds = if ($null -ne $p.TimeoutSeconds) { [int]$p.TimeoutSeconds } else { 180 }
    $MaxLogBytes = if ($null -ne $p.MaxLogBytes) { [int]$p.MaxLogBytes } else { 2097152 }

    if (-not (Test-Path -LiteralPath $EditorExe)) { throw "editor not found: $EditorExe" }
    if (-not (Test-Path -LiteralPath $ProjectPath)) { throw "project not found: $ProjectPath" }

    $logDir = Join-Path $env:TEMP "uecm-log-verify-$(Get-Random)"
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $logFile = Join-Path $logDir 'verify.log'

    $ueArgs = @(
        $ProjectPath,
        '-nullrhi',
        '-nosound',
        '-unattended',
        '-nopause',
        '-ExecCmds=quit',
        '-logcmds=LogDerivedDataCache Verbose',
        "-abslog=$logFile"
    )
    $proc = Start-Process -FilePath $EditorExe -ArgumentList $ueArgs -PassThru -WindowStyle Hidden
    if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
        try { $proc.Kill() } catch {}
        throw "editor did not exit within $TimeoutSeconds s"
    }
    if (-not (Test-Path -LiteralPath $logFile)) { throw "log not produced at $logFile" }
    $size = (Get-Item $logFile).Length
    $content = if ($size -le $MaxLogBytes) {
        Get-Content -LiteralPath $logFile -Raw -Encoding UTF8
    } else {
        $bytes = [System.IO.File]::ReadAllBytes($logFile)
        $tail = $bytes[($bytes.Length - $MaxLogBytes)..($bytes.Length - 1)]
        [System.Text.Encoding]::UTF8.GetString($tail)
    }
    @{
        ok        = $true
        log_path  = $logFile
        size      = $size
        truncated = ($size -gt $MaxLogBytes)
        content   = $content
        exit_code = $proc.ExitCode
    } | ConvertTo-Json -Compress -Depth 4
}
catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
