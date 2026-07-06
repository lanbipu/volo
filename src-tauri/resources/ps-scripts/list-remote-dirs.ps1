# Lists immediate subdirectories of a path, or (Path empty/null) the machine's
# fixed local drives — powers the DDC PAK 搜索根目录地址栏逐级下拉提示。
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "Path": "D:\\Projects" | null }
# Output: JSON { ok, entries: ["Helios", "Aurora", ...] }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Continue'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $path = $p.Path

    if ([string]::IsNullOrEmpty($path)) {
        $drives = [System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady }
        $entries = @($drives | ForEach-Object { $_.RootDirectory.FullName.TrimEnd('\') })
        @{ ok = $true; entries = $entries } | ConvertTo-Json -Compress
    }
    elseif (-not (Test-Path -LiteralPath $path)) {
        # Path doesn't exist yet (user still mid-typing a segment) — empty
        # suggestion list, not a hard error.
        @{ ok = $true; entries = @() } | ConvertTo-Json -Compress
    }
    else {
        $dirs = Get-ChildItem -LiteralPath $path -Directory -ErrorAction SilentlyContinue | Sort-Object Name
        $entries = @($dirs | ForEach-Object { $_.Name })
        @{ ok = $true; entries = $entries } | ConvertTo-Json -Compress
    }
}
catch {
    @{ ok = $false; entries = @(); message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}
