# Copy a local file into the node's outbound transfer staging dir so the
# operator can scp-pull it via a space-free, quoting-safe path.
#
# Node-pure: runs locally on the SOURCE machine of an SSH-push distribute
# (shipped + executed via SSH -File). Only used when the source machine is
# not the operator itself (loopback sources are read directly).
#
# stdin: JSON { "SourcePath","StagedName" }
# Output: JSON { ok, staged_path, size, [message] }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $SourcePath = $p.SourcePath
    $StagedName = $p.StagedName
    if ([string]::IsNullOrWhiteSpace($SourcePath) -or [string]::IsNullOrWhiteSpace($StagedName)) {
        throw "SourcePath and StagedName are required"
    }
    if (-not (Test-Path -LiteralPath $SourcePath)) {
        throw "source file missing: $SourcePath"
    }
    $outDir = 'C:\ProgramData\UECM\transfer\out'
    if (-not (Test-Path -LiteralPath $outDir)) {
        New-Item -Path $outDir -ItemType Directory -Force | Out-Null
    }
    $staged = Join-Path -Path $outDir -ChildPath $StagedName
    Copy-Item -LiteralPath $SourcePath -Destination $staged -Force
    $size = (Get-Item -LiteralPath $staged).Length
    @{ ok = $true; staged_path = $staged; size = "$size" } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; staged_path = ""; size = "0"; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}
