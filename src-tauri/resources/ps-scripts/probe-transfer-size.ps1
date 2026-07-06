# Report the current size of a staged transfer file (progress polling for the
# SSH-push distribute: the operator polls this while scp is writing the file
# into the staging dir and converts bytes into UI progress events).
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "Path" }
# Output: JSON { ok, size }   (size = -1 when the file does not exist yet)
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $Path = $p.Path
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "Path is required" }
    $size = "-1"
    if (Test-Path -LiteralPath $Path) { $size = "$((Get-Item -LiteralPath $Path).Length)" }
    @{ ok = $true; size = $size } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; size = "-1"; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}
