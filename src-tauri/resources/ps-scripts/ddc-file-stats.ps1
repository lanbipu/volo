# Returns {file_count, total_bytes} for one or two paths (Local + Shared DDC).
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "LocalPath": "...", "SharedPath": "..." }
# Output: JSON { ok, local, shared }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Continue'

function StatPath($pth) {
    if ([string]::IsNullOrEmpty($pth)) { return @{ path = ""; ok = $false; file_count = 0; total_bytes = 0; error = "empty" } }
    try {
        if (-not (Test-Path -LiteralPath $pth)) { return @{ path = $pth; ok = $false; file_count = 0; total_bytes = 0; error = "not found" } }
        $files = Get-ChildItem -LiteralPath $pth -Recurse -Force -File -ErrorAction SilentlyContinue
        $count = ($files | Measure-Object).Count
        $bytes = ($files | Measure-Object Length -Sum).Sum
        if (-not $bytes) { $bytes = 0 }
        @{ path = $pth; ok = $true; file_count = $count; total_bytes = [int64]$bytes }
    } catch {
        @{ path = $pth; ok = $false; error = $_.Exception.Message; file_count = 0; total_bytes = 0 }
    }
}

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    @{
        ok     = $true
        local  = (StatPath $p.LocalPath)
        shared = (StatPath $p.SharedPath)
    } | ConvertTo-Json -Compress -Depth 5
}
catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
